import superjson from "superjson"
import { GetServerSideProps } from "next"
import { Heading, VStack } from "@chakra-ui/react"
import { PageWrapper } from "components/PageWrapper"
import { ContentContainer } from "components/utils/ContentContainer"
import SpecList from "components/SpecList"
import { OpenApiSpec } from "@common/types"
import { getSpecs } from "api/apiSpecs"

const Specs = ({ apiSpecs }) => (
  <PageWrapper title="API Specs">
    <ContentContainer>
      <VStack w="full" alignItems="flex-start">
        <Heading fontWeight="semibold" size="lg">
          API Specs
        </Heading>
        <SpecList apiSpecs={superjson.parse<OpenApiSpec[]>(apiSpecs)} />
      </VStack>
    </ContentContainer>
  </PageWrapper>
)

export const getServerSideProps: GetServerSideProps = async context => {
  const apiSpecs = await getSpecs()
  return { props: { apiSpecs: superjson.stringify(apiSpecs) } }
}

export default Specs
